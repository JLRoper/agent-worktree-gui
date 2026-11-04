# Splitting `server.js` into route modules

*What the dispatcher is made of, what each route closes over, and the order a crew can cut it in.*

- Snapshot: **`e2358c5`**, the tip of `wtgui/split-research-1-server-4f1da3` (`package.json` `1.4.0`).
  `server.js` is 5,833 lines, blob `6507f7cffc4daeada05bb7564797647f90bb54ad`.
- This page **extends** [`lanes-and-modules.md`](lanes-and-modules.md) §10 — the measured sizes and the
  disagreement table — and does not redo it. §10's server-side numbers are this tip's numbers: `server.js` is
  byte-identical to `origin/main`'s at `1e1c595`, where that page lives (`git rev-parse HEAD:server.js
  origin/main:server.js` returns the same blob), and `lib/` and `public/` are identical between the two tips.
  The one figure re-checked here is the dispatch count, because every group below is a partition of it:
  136, as §10 says.
- What §10 does not have, and this page adds: a line range and a method for **every** route; the seam each
  route closes over; the spine that must stay; the thirteen route files a crew would create; the one file every
  extraction still edits; and the order.
- This is research. No file outside `docs/reviews/` is changed.

**Contents**

1. [The dispatcher in numbers](#1-the-dispatcher-in-numbers)
2. [The seam contract](#2-the-seam-contract)
3. [The spine](#3-the-spine)
4. [The thirteen groups and their files](#4-the-thirteen-groups-and-their-files)
5. [Every route](#5-every-route)
6. [The mount, and the one file each extraction still touches](#6-the-mount-and-the-one-file-each-extraction-still-touches)
7. [What can run in parallel, and the extraction order](#7-what-can-run-in-parallel-and-the-extraction-order)
8. [Verifying one extraction](#8-verifying-one-extraction)
9. [What this page found but did not fix](#9-what-this-page-found-but-did-not-fix)
10. [What this page did not do](#10-what-this-page-did-not-do)
- [Appendix A — re-measuring this page](#appendix-a--re-measuring-this-page)

---

## 1. The dispatcher in numbers

`server.js` is one Node process, ESM, `"dependencies": {}`, no build step. `createServer` opens at 2,378.
Everything before it is the composition root; everything after the handler is boot, sweeps and shutdown.

| What | Value |
|---|---|
| `server.js` | 5,833 lines |
| before `createServer` — the composition root | 2,377 lines |
| `createServer` opens | 2,378 |
| the request handler | 2,378–5,589 (3,212 lines) |
| dispatch preamble: `url`, `route`, the POST-except-reload flag | 2,378–2,395 (18 lines) |
| first route condition | 2,396 |
| last route condition | 5,571 |
| dispatch conditions | **136** |
| distinct API paths in those conditions | 137 |
| API paths already served by mounted `lib/` factories | 3 |
| methods, as written | 93 `POST`, 35 `GET`, 3 `PUT`, 5 with no method test |
| blocks that call `authorised` | 102 |
| blocks that read a body | 89 (88 `readBody`, 1 `readRawBody`) |
| lines inside route blocks | 2,661 |
| lines of comments and blank between them | 515 |
| `return sendJson(` inside the route blocks | 465 |
| tail after the handler | 5,590–5,833 (244 lines) |

The 136 are 135 `if (route === …)` blocks — one of which carries two paths, `/api/state` and `/api/audit`
— plus the single `route.startsWith("/api/approvals/")` block. Three more paths are already module-owned and
mounted at 2,388–2,394: `/api/assistant/queue` (`lib/assistant/queue.js`), `/api/assistant/task-pipeline`
(`lib/pipeline-window.js`) and `/api/assistant/pipeline-catalogue` (`lib/task-pipeline-assign.js`). The panel
therefore answers **140 API paths**: 136 inline conditions carrying 137 paths, plus those three.

Two facts shape every cut below:

- **Every condition is claimed once.** A path may appear in two blocks when the methods differ
  (`/api/settings/sessions` GET and POST; `/api/restart` GET and POST), but every block belongs to exactly one
  group, and no two groups' deletions overlap. Only one local is shared between blocks (§2).
- **The blocks are not contiguous.** A group is a set of blocks in one to four regions of the file, separated
  by other groups' routes. The summary table in §4 gives the regions; §5 gives every block.

---

## 2. The seam contract

The three existing extraction precedents — `createQueueRoutes`, `createPipelineWindowRoutes`,
`createPipelineCatalogueRoutes` — all have the same shape: a factory is handed the exact names it needs and
returns `(req, res, route, url) => Promise<boolean>`, answering `true` only for a path it owns. Every new
module follows it.

```js
// lib/routes/settings.js
export function createSettingsRoutes({
  getConfig, getScheduler, jobs, registry, matrixBridge,
  sendJson, readBody, authorised, broadcast, snapshot, settingsOut, log, patchPanelConfig,
}) {
  return async function settingsRoutes(req, res, route, url) {
    const reply = (...a) => (sendJson(res, ...a), true);

    if (route === "/api/settings/sessions" && req.method === "GET") {
      return reply(200, await sessionSettings());
    }
    // …
    return false;
  };
}
```

Six rules. Each one is a defect this file has already paid for somewhere else.

1. **Exact paths only.** A module tests `route === "…"` (or `req.method` plus the exact path) and returns
   `false` for anything else. The one prefix route in the file, `/api/approvals/`, is the *last* test in its
   module, after `/api/approvals/answer`; otherwise it swallows the answer route. A new module that used
   `route.startsWith("/api/assistant/")` would swallow the three factory-mounted assistant paths.

2. **`reply`, never `return sendJson`.** `sendJson` returns `undefined`. A module that hands that back makes
   the router fall through to `serveStatic` *after* the headers are on the wire, which throws
   `ERR_HTTP_HEADERS_SENT` inside the handler's catch. The route blocks have 465 `return sendJson(` sites (466
   in the whole handler, counting the catch's own answer); inside
   a module they all become `reply`, and the rewrite is mechanical: `s/return sendJson(/return reply(/`.
   A `res.headersSent` fall-through at the end of a module also "works" and is rejected: it hides a
   mis-ordered route instead of making it visible.

3. **No module-level try/catch.** The handler's catch at 5,574–5,588 is the one error mapper: `errorStatus(e)`,
   a 500 log line with the stack, and `res.destroy()` when the headers already went out. A module that
   swallows a throw changes the status the page sees. Keep only the local catches the block already had.

4. **Live values are getters.** `/api/reload` rebinds `config`, `pool` and `scheduler` (5,512–5,516). A module
   handed those objects at mount time keeps the *old* ones after the first reload. Exactly three getters:
   `getConfig`, `getPool`, `getScheduler`. The repo already states the rule for the spawner: "the two answers
   that go stale are passed as getters: `/api/reload` replaces `config` wholesale" (813–814). `assistant`,
   `restart` and `naming` are assigned once and can be handed by value.

5. **Hand in the spine's state and helpers; import the library directly.** A route module imports `gitIn`,
   `scanWorktree`, `approvals`, `sendJson` and the rest of `lib/` itself. It is handed only the objects and
   functions that live in `server.js`. The seam column in §5 is the measured list; §4 splits each group's list
   into *handed in* and *re-imported*.

6. **Do not re-indent.** A block lifted out of the dispatcher keeps its 4-space `if` and 6-space body inside
   the factory. That makes the move provable: after `s/return sendJson(/return reply(/`, the extracted text
   must be byte-identical to the deleted text (§8).

**The one shared local.** The dispatcher declares one variable outside the route blocks that a route family
closes over:

```js
// server.js:2,662
const profilesFile = config.providerProfilesFile;
```

It is used by the three `/api/settings/provider/profiles…` routes (GET, POST, delete). A block-by-block move
would leave it behind. The settings module computes it from `getConfig()` before its first test — the path is
fixed at boot, so once at factory time is also correct — and every profile route uses that name.

**The one pre-dispatch side effect.** At 2,381 the handler clears `bootPassCanSatisfyReload` for every POST
except `/api/reload`. That must stay above the mounts: it is about the process, not about a route.

---

## 3. The spine

The spine is everything a route module may *ask* and nothing it may *own*. Measured bands, with the reason
each cannot leave:

| Band | Lines | What it holds | Why it stays |
|---|---|---|---|
| imports | 1–98 | `node:` builtins, `lib/` modules, the one client side-effect import | every module imports its own |
| config | 100–382 | `VERSION`, `HERE`, `CONFIG_FILE`/`CONFIG_PATH`, `loadConfig`, `writeConfigAtomic`, `patchPanelConfig` | one loader, one set of normalised defaults; `/api/reload` re-reads it |
| boot guards | 384–426 | `portHolder`, `ensureDirs`, `migrateState`, the two size walks | they run before a request can exist |
| the stores | 427–484 | `Pool`, `Store`, `TreeNames`, `Hosts`, `Pipelines`, `PipelineRecords`, `ProjectRegistry`, `Scheduler`, `clients` | one instance each; every route reads or mutates them |
| events and jobs | 486–614 | `broadcast`, `guard`, `adoptFromJob`, `Jobs`, `Approvals` | the job event fan-out is wired at construction |
| remote writes and the guard | 616–808 | `guardRecord`, `installGuardFor`, `refreshGuards`, `guardReport`, `setRemotePolicy`, `RemoteWrites` | the job hook at 718 and the routes share them |
| spawn, locks, assistant | 810–874 | `spawnFeature`, `rowsWithProject`, `locks`, `Assistant`, the three mounted route factories | spawn admission; the queue's routes |
| restart | 876–915 | `RestartController`, `resumePending`, the orphan sweeps | it owns the process exit |
| decorations and timers | 1009–1500 | `ElementChannel`, naming, pipeline waits, `TodoLists`, releases, deliverables | timers and boot wiring |
| view assembly | 1500–2275 | `withReleases` … `withAssistantOwners`, `settingsOut`, `pathsInfo`, `snapshot` | one snapshot shape for `/api/state`, SSE and every broadcast |
| boot pass | 2370–2377 | `bootConfigJson`, `bootPass`, `bootPassCanSatisfyReload` | `/api/reload` awaits it |
| handler framing | 2378–2396, 5574–5589 | `url`, `route`, the POST flag, the mounts, the catch | HTTP framing |
| spine routes | 5502–5571 | reload, restart, restart/cancel, stream | they rebind the spine or need `clients` + `snapshot` |
| static | 166–167, 5573 | `createBuild`, `serveStatic`, `PUBLIC_DIR` | the fall-through for every unmatched path |
| tail | 5590–5833 | `warmParents`, the checked-landings sweep, `listen`, `shutdown` | process lifetime |

The five spines named in the brief, located:

- **Config** — 154–382 (`CONFIG_FILE`/`CONFIG_PATH`, `loadConfig` at 198, `writeConfigAtomic` at 341,
  `patchPanelConfig` at 373) and the reload route at 5,502. `loadConfig` normalises more than thirty keys
  (port, host, five clock values, chart columns, scan mode, matrix, every state path). A route may mutate
  `getConfig()` in place — the settings routes do — but a second loader would be a second set of defaults.
- **Store** — `new Store()` at 428, the registry at 462, the scheduler at 471, `store.onEvent` at 515, and
  `snapshot()` at 2,234. Rows are produced by the scheduler's worker threads and consumed here; routes read
  `store.rowsFor`, `store.rows`, `store.snapshot`, never write rows themselves.
- **Job admission** — `new Jobs(` at 546–571, `jobs.afterWorktreeCreate` at 718–726, `createSpawn` at 815–819,
  and the assistant's `spawner` at 848. Admission is one object's decision (gateway reachable, tree is a
  checkout, nothing live already there) and the event fan-out (broadcast, adopt, naming, descriptions,
  release, assistant) is wired in the constructor. A route asks `jobs` or `spawnFeature`; it never owns one.
- **Restart** — `RestartController` at 880–895, the three routes at 5,531–5,569, `shutdown` at 5,807. A
  restart kills the process that answers the request, so the queue, the wait-for-turn proof and the resume
  wake are the controller's, not a route module's.
- **Static and asset serving** — `createBuild` at 166, `serveStatic` at 5,573. It is the fall-through: a route
  module that forgets `return true` lands here with the headers already sent. `/api/stream` at 5,571 is the
  other fall-through-shaped route, and it stays for `clients` + `snapshot`.

What the spine is **not** allowed to keep growing: the route blocks. After all thirteen groups are out, the
handler is the preamble, one mount, the three spine routes, the static fall-through and the catch — about
35 lines instead of 3,212.

---

## 4. The thirteen groups and their files

Every group is one new file under `lib/routes/`, named by the domain it serves, plus any helper whose only
callers are that group's routes (one helper for four groups, three for `conversations`, none for the rest).
Wave 0 also creates `lib/routes/index.js`, the mechanism in §6.1 — fourteen new files in total, thirteen of
them groups.

The split rule was: **one owner per condition, one owner per moved helper, and no group's deletion range
overlapping another's.** A GET and a POST of the same path stay in the same module. The result is thirteen
files, 131 routes, 2,603 body lines; the remaining 5 routes are the spine's.

| # | Group | File | Routes | Body lines | Blocks / regions | Hand-ins | Wave |
|---|---|---|---|---|---|---|---|
| 1 | system | `lib/routes/system.js` | 5 | 25 | 5 / 3 | 10 | 0 |
| 2 | assistant | `lib/routes/assistant.js` | 26 | 257 | 26 / 1 | 5 | 1 |
| 3 | pipelines | `lib/routes/pipelines.js` | 2 | 77 | 2 / 1 | 3 | 2 |
| 4 | todos | `lib/routes/todos.js` | 2 | 38 | 2 / 1 | 3 | 2 |
| 5 | approvals | `lib/routes/approvals.js` | 4 | 24 | 4 / 1 | 3 | 2 |
| 6 | settings | `lib/routes/settings.js` | 25 | 318 | 25 / 3 | 15 | 3 |
| 7 | panel-io | `lib/routes/panel-io.js` | 7 | 164 | 7 / 4 | 11 | 4 |
| 8 | projects | `lib/routes/projects.js` | 11 | 232 | 11 / 4 | 11 | 4 |
| 9 | worktrees | `lib/routes/worktrees.js` | 7 | 350 | 7 / 2 | 19 | 5 |
| 10 | remote-writes | `lib/routes/remote-writes.js` | 9 | 235 | 9 / 1 | 17 | 6 |
| 11 | landing | `lib/routes/landing.js` | 5 | 335 | 5 / 3 | 17 | 7 |
| 12 | conversations | `lib/routes/conversations.js` | 17 | 406 | 17 / 4 | 20 | 8 |
| 13 | jobs | `lib/routes/jobs.js` | 11 | 142 | 11 / 4 | 8 | 9 |
| — | **spine** | stays in `server.js` | 5 | 58 | 5 / 1 | — | — |

Body lines are the sum of the route blocks; regions are merged spans of the group's blocks (a gap of ≤50 lines
between two of its blocks stays in one region). Hand-ins count the module-level names in the seam column that
are **not** `lib/` imports — the state objects and spine helpers the factory must receive.

No group needs a new test file. The move is a pure move, and the existing suite (168 files) plus the panel
harness already drives the routes; a unit test for a factory would stub the seam that the extraction is
supposed to preserve, which is the opposite of the proof §8 asks for. If a group adds one anyway, it is a
sixth file the worker creates, and it claims `test/` in the row.

### 4.1 system — `lib/routes/system.js`, `createSystemRoutes`

5 routes, 25 body lines, 5 blocks in 3 regions: 2,396–2,412, 3,323–3,325, 3,869–3,877.

- **Handed in:** `getConfig`, `getPool`, `getScheduler`, `build`, `clients`, `jobs`, `registry`, `store`,
  `settingsOut`, `snapshot`.
- **Re-imported:** `sendJson`, `path`.
- **Moves:** none. This is the seam's proof: the smallest group, five reads, no helper.

### 4.2 assistant — `lib/routes/assistant.js`, `createAssistantRoutes`

26 routes, 257 body lines, 26 blocks in one region: 2,827–3,150.

- **Handed in:** `assistant`, `element`, `jobs`, `getConfig`, `broadcast`.
- **Re-imported:** `authorised`, `readBody`, `sendJson`, `saveProfile`.
- **Moves:** none. The three module-mounted assistant paths (queue, task-pipeline, pipeline-catalogue) are
  **not** in this file; their factories ride in the same router table as three already-built handlers (§6.1).

### 4.3 pipelines — `lib/routes/pipelines.js`, `createPipelinesRoutes`

2 routes, 77 body lines, 2 blocks in one region: 2,476–2,563. GET reads, PUT replaces the catalogue.

- **Handed in:** `getConfig`, `log`, `pipelines`.
- **Re-imported:** `authorised`, `readBody`, `sendJson`, `readPipelinesFile`, `validatePipelinesDocument`,
  `PIPELINES_VERSION`, `PIPELINE_KINDS`, `EXIT_CHECKS`.
- **Moves:** none. The PUT is the file's validation edge — its findings are returned unaltered, so the module
  must not re-word them.

### 4.4 todos — `lib/routes/todos.js`, `createTodosRoutes`

2 routes, 38 body lines, 2 blocks in one region: 3,928–3,966.

- **Handed in:** `todos`, `broadcastTodos`, `todoSay`.
- **Re-imported:** `authorised`, `path`, `readBody`, `sendJson`.
- **Moves:** none. `broadcastTodos`/`todoSay` are only used here and could move into the module; keeping them
  in the spine costs 26 lines and keeps the snapshot's TODO decorator beside its store.

### 4.5 approvals — `lib/routes/approvals.js`, `createApprovalsRoutes`

4 routes, 24 body lines, 4 blocks in one region: 3,895–3,921.

- **Handed in:** `approvals`, `getConfig`, `log`.
- **Re-imported:** `authorised`, `readBody`, `sendJson`.
- **Moves:** none. **Order inside the module:** `/api/approvals` (exact), `/api/approvals/answer` (exact),
  then the `/api/approvals/` prefix list.

### 4.6 settings — `lib/routes/settings.js`, `createSettingsRoutes`

25 routes, 318 body lines, 25 blocks in 3 regions: 2,425–2,468, 2,565–2,822, 4,711–4,822.

- **Handed in:** `getConfig`, `getScheduler`, `jobs`, `registry`, `matrixBridge`, `broadcast`, `snapshot`,
  `settingsOut`, `log`, `patchPanelConfig`, `warmModelPrices`, `chartTopCountFrom`, `collapseAfterSecondsFrom`,
  `CONFIG_PATH`, `HERE`.
- **Re-imported:** `authorised`, `readBody`, `sendJson`, `sessionSettings`, `writeSessionListLimit`,
  `SESSION_LIST_MIN`, `SESSION_LIST_MAX`, `approvalState`, `writeApprovalTimeout`, `APPROVAL_TIMEOUT_MIN`,
  `APPROVAL_TIMEOUT_MAX`, `providerState`, `writeProviderSettings`, `listProfiles`, `saveProfile`,
  `deleteProfile`, `profileWithKey`, `matrixBlock`, `matrixPatchFrom`, `readSkillsIndex`, `readPermissions`,
  `hermesHome`, `modelCatalogue`, `refreshModelCatalogue`, `chartColumnsFrom`, `path`.
- **Moves:** none. Special cases: `profilesFile` (§2), and the five routes that mutate `getConfig()` in place
  after `patchPanelConfig` — `scan`, `cleanup`, `chart-top`, `collapse-after`, `columns`.

### 4.7 panel-io — `lib/routes/panel-io.js`, `createPanelIoRoutes`

7 routes, 164 body lines, 7 blocks in 4 regions: 3,331–3,412, 3,887–3,889, 4,827–4,901, 4,952–4,972.
It is the panel's "open something on this box" surface: open a path or URL, clean scratch, the two cleanup
reads, and the two deliverables.

- **Handed in:** `getConfig`, `broadcast`, `deliverables`, `jobs`, `log`, `pathsInfo`, `registry`, `snapshot`,
  `editorFor`, `CONFIG_DIR`, `HERE`.
- **Re-imported:** `authorised`, `readBody`, `sendJson`, `safeUrl`, `openerFor`, `openerForFolder`, `chromeFor`,
  `cleanScratch`, `ensureDirs`, `humanBytes`, `sizeOf`, `homedir`, `spawn`, `stat`, `path`.
- **Moves:** `editorFor` (106–129, 24 lines) — only `/api/open-path` calls it.

### 4.8 projects — `lib/routes/projects.js`, `createProjectsRoutes`

11 routes, 232 body lines, 11 blocks in 4 regions: 3,419–3,522, 3,864–3,867, 4,265–4,299, 5,395–5,500.
Clone, new project, fetch, first commit, host mappings, the steward plan/apply, and the parents read.

- **Handed in:** `getConfig`, `getScheduler`, `broadcast`, `hosts`, `hostsFile`, `log`, `normPathKey`,
  `parents`, `registry`, `snapshot`, `stewardProject`.
- **Re-imported:** `authorised`, `readBody`, `sendJson`, `gitIn`, `proposeMapping`, `applyPlan`, `readPlan`,
  `writePlan`, `stewardWorktrees`, `rm`, `stat`, `writeFile`, `path`.
- **Moves:** `stewardProject` (2,221–2,232, 12 lines) — only the three steward routes call it.

### 4.9 worktrees — `lib/routes/worktrees.js`, `createWorktreesRoutes`

7 routes, 350 body lines, 7 blocks in 2 regions: 3,156–3,321, 3,535–3,765. Locking, the per-tree owner, a
transfer, the child cut, the roll-up, the rebase and the parent question.

- **Handed in:** `getConfig`, `getScheduler`, `getPool`, `assistant`, `assistantForRow`, `broadcast`, `guard`,
  `jobs`, `locks`, `log`, `normPathKey`, `ownerFields`, `parents`, `questions`, `registry`, `snapshot`,
  `spawnFeature`, `store`, `treeNames`.
- **Re-imported:** `authorised`, `readBody`, `sendJson`, `pageCaller`, `cutChildWorktree`, `ownCopyOf`,
  `parentWorktreeOf`, `rebaseKey`, `rebaseWorktree`, `rollGate`, `rollUp`, `scanWorktree`, `stewardWorktrees`,
  `treeKey`, `worktreeList`, `writerLocks`, `DEFAULT_OWNER`, `stat`, `path`.
- **Moves:** none. `ownerFields`/`assistantForRow` also decorate the snapshot (2,096–2,132), so they stay in the
  spine and are handed in. `pageCaller` guards the two routes that may only be called by the page itself
  (3,213, 3,256).

### 4.10 remote-writes — `lib/routes/remote-writes.js`, `createRemoteWritesRoutes`

9 routes, 235 body lines, 9 blocks in one region: 3,970–4,237. The permission box, a grant, the guard
install/refresh and the policy write.

- **Handed in:** `getConfig`, `getScheduler`, `store`, `registry`, `remoteWrites`, `spawnFeature`, `guardRecord`,
  `guardReport`, `installGuardFor`, `setRemotePolicy`, `writeGuardRecord`, `settingsOut`, `cleanPath`,
  `normPathKey`, `log`, `execP`, `CONFIG_PATH`.
- **Re-imported:** `authorised`, `readBody`, `sendJson`, `gitIn`, `policyForProject`, `uninstallGuard`,
  `normTree`, `POLICIES`, `DEFAULT_POLICY`, `stat`, `path`.
- **Moves:** none. `installGuardFor` is also the job hook (718), `refreshGuards` the boot pass (946) and the
  grant callback (788), `setRemotePolicy` the `RemoteWrites.onPolicy` wiring (785). All four stay in the spine
  and are handed in; moving them would make a route module a dependency of the job stream.

### 4.11 landing — `lib/routes/landing.js`, `createLandingRoutes`

5 routes, 335 body lines, 5 blocks in 3 regions: 3,777–3,862 (pipeline assignment), 4,930–4,949 (delete),
5,142–5,277 (merge), 5,289–5,368 (verify-landed), 5,376–5,388 (rename).

- **Handed in:** `getConfig`, `getScheduler`, `broadcast`, `hosts`, `jobs`, `locks`, `log`, `normPathKey`,
  `pipelineRecords`, `pipelines`, `registry`, `remoteWrites`, `renameWorktree`, `snapshot`, `spawnFeature`,
  `store`, `PIPELINE_SWITCH_STARTS_TURN`.
- **Re-imported:** `authorised`, `readBody`, `sendJson`, `gitIn`, `mergeLabel`, `mergePrompt`, `verifyLabel`,
  `verifyPrompt`, `answerDeletes`, `deleteWorktreeRow`, `scanWorktree`, `worktreeList`, `changePipeline`,
  `describeNaming`, `presumedPipeline`, `storeSwitch`, `policyForProject`, `isLiveJobStatus`, `makeThreadName`,
  `stat`, `path`, `tmpdir`.
- **Moves:** none. `renameWorktree` (1,576–1,945, 370 lines) is also the assistant's `onRename` handler
  (1,932), so it cannot move into this module without making the assistant depend on a route file. Hand it in;
  a later cut can move it to `lib/worktree-rename.js` and both callers can import it.
- This is the widest seam in the file: 17 hand-ins and 22 re-imports, including the 136-line merge route.

### 4.12 conversations — `lib/routes/conversations.js`, `createConversationsRoutes`

17 routes, 406 body lines, 17 blocks in 4 regions: 4,239–4,379 (agents, preview, reply, threads, attachments),
4,467–4,632 (thinking, tool results, tool calls, subagents, sessions, revive), 4,698–4,705 (refresh),
4,983–5,136 (row refresh and its agent).

- **Handed in:** `getConfig`, `getScheduler`, `getPool`, `assistant`, `broadcast`, `cleanPath`, `descriptions`,
  `jobs`, `log`, `normPathKey`, `ownerOnRow`, `refreshLog`, `registry`, `sessionsForRow`, `snapshot`,
  `spawnFeature`, `startRowRefreshAgent`, `startThreadReply`, `store`, `todos`.
- **Re-imported:** `authorised`, `readBody`, `readRawBody`, `sendJson`, `childTranscript`, `collectPrompt`,
  `subagentsFor`, `subagentRoster`, `thinkingFor`, `hermesSessionTail`, `liveRunIn`, `mergeDelta`,
  `normaliseRefreshAgent`, `parseCommitFiles`, `todoProposals`, `isLiveJobStatus`, `hermesHome`, `mkdir`,
  `writeFile`, `gitIn`, `path`, `ASSISTANT_THREAD`, `REFRESH_LINES_SHOWN`.
- **Moves:** `sessionsForRow` (2,324–2,327, 4 lines), `refreshAgentPrompt` (2,335–2,350, 16 lines) and
  `startRowRefreshAgent` (2,351–2,368, 18 lines). `startThreadReply` (1,158–1,209) stays: the stage timer's
  wake also calls it (1,289), so it is spine state, handed in.

### 4.13 jobs — `lib/routes/jobs.js`, `createJobsRoutes`

11 routes, 142 body lines, 11 blocks in 4 regions: 3,879–3,882 (the list), 4,381–4,459 (cancel, steer,
reattach, ask-complete, approve, answer), 4,634–4,696 (attach, label, clear), 4,905–4,923 (artifact delete).

- **Handed in:** `getConfig`, `assistant`, `broadcast`, `jobs`, `gonePointers`, `STEER_PARKED`, `STEER_PAST_BOUNDARY`, `STEER_GONE` (the `globalThis.wtSteerable` constants at line 100, used only by `/api/jobs/steer`).
- **Re-imported:** `authorised`, `readBody`, `sendJson`, `gitIn`, `unlink`, `stat`, `path`.
- **Moves:** `gonePointers` (576–613, 38 lines) — only `/api/jobs/reattach` calls it (4,418).

### 4.14 The spine's own routes

Five blocks, 58 body lines, one region: 5,502–5,571.

| Path | Method | Lines | Why it stays |
|---|---|---|---|
| `/api/reload` | POST | 5,502–5,524 | rebinds `config`, `pool`, `scheduler`; awaits `bootPass` |
| `/api/restart` | GET | 5,531–5,533 | reads the controller's queue |
| `/api/restart` | POST | 5,535–5,551 | queues a restart; the controller owns the process |
| `/api/restart/cancel` | POST | 5,556–5,569 | cancels a queued restart |
| `/api/stream` | any | 5,571 | `handleStream(req, res, { clients, snapshot })` |

These are not a group. They are the five blocks of the handler that cannot be a pure function of the stores,
and they are why "extract every route" is not the goal: extract every route that *can* be.

---

## 5. Every route

One row per dispatch condition, in file order inside each group. **Lines** is the block's own span at
`e2358c5`; **Body** is its line count. **Method** is what the condition tests — `any` means the block does
not test `req.method` at all.

**Seam** is every name the block closes over besides the four dispatch locals `req`, `res`, `url` and `route`.
A name imported from `lib/` can be imported again by the new module; every other name is module-level state or
a function defined in `server.js` and must be handed in (§4 splits each group's list). The transport names —
`sendJson`, `readBody`, `readRawBody`, `authorised`, `pageCaller` — are imports from `lib/http/transport.js`
and travel in from the composition root, exactly as they do for `createQueueRoutes`.

### 5.1 system — 5 routes, 25 body lines, 5 blocks in 3 regions

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/health` | any | 2396–2398 | 3 | clients, config, registry, sendJson, settingsOut |
| 2 | `/api/build` | GET | 2402–2404 | 3 | build, sendJson |
| 3 | `/api/config` | any | 2406–2412 | 7 | config, path, registry, sendJson, settingsOut |
| 4 | `/api/state`, `/api/audit` | any | 3323–3325 | 3 | sendJson, snapshot |
| 5 | `/api/stats` | any | 3869–3877 | 9 | clients, jobs, pool, scheduler, sendJson, store |

### 5.2 assistant — 26 routes, 257 body lines, 26 blocks in 1 region

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/assistant` | GET | 2827–2829 | 3 | assistant, sendJson |
| 2 | `/api/assistant/messages` | GET | 2835–2845 | 11 | assistant, sendJson |
| 3 | `/api/assistant/charter` | GET | 2851–2853 | 3 | assistant, sendJson |
| 4 | `/api/assistant/charter` | PUT | 2854–2870 | 17 | assistant, authorised, config, readBody, sendJson |
| 5 | `/api/assistant/role` | GET | 2881–2888 | 8 | assistant, sendJson |
| 6 | `/api/assistant/role` | PUT | 2889–2904 | 16 | assistant, authorised, config, readBody, sendJson |
| 7 | `/api/assistant/role/pick` | POST | 2907–2916 | 10 | assistant, authorised, config, readBody, sendJson |
| 8 | `/api/assistant/profile` | POST | 2923–2941 | 19 | assistant, authorised, config, readBody, saveProfile, sendJson |
| 9 | `/api/assistant/roles` | POST | 2942–2951 | 10 | assistant, authorised, config, readBody, sendJson |
| 10 | `/api/assistant/assistants` | POST | 2954–2964 | 11 | assistant, authorised, config, readBody, sendJson |
| 11 | `/api/assistant/say` | POST | 2968–2979 | 12 | assistant, authorised, config, readBody, sendJson |
| 12 | `/api/assistant/settings` | POST | 2981–2995 | 15 | assistant, authorised, config, readBody, sendJson |
| 13 | `/api/assistant/aggressive` | POST | 3001–3007 | 7 | assistant, authorised, config, readBody, sendJson |
| 14 | `/api/assistant/alert` | POST | 3011–3020 | 10 | assistant, authorised, config, readBody, sendJson |
| 15 | `/api/assistant/answer` | POST | 3023–3037 | 15 | assistant, authorised, config, readBody, sendJson |
| 16 | `/api/assistant/element` | GET | 3042–3044 | 3 | element, sendJson |
| 17 | `/api/assistant/element/retry` | POST | 3047–3056 | 10 | authorised, config, element, readBody, sendJson |
| 18 | `/api/assistant/answer-question` | POST | 3060–3070 | 11 | assistant, authorised, broadcast, config, jobs, readBody, sendJson |
| 19 | `/api/assistant/spawn` | POST | 3075–3087 | 13 | assistant, authorised, broadcast, config, jobs, readBody, sendJson |
| 20 | `/api/assistant/watch` | POST | 3089–3098 | 10 | assistant, authorised, config, readBody, sendJson |
| 21 | `/api/assistant/watch/remove` | POST | 3099–3103 | 5 | assistant, authorised, config, readBody, sendJson |
| 22 | `/api/assistant/rule` | POST | 3105–3114 | 10 | assistant, authorised, config, readBody, sendJson |
| 23 | `/api/assistant/rule/remove` | POST | 3115–3119 | 5 | assistant, authorised, config, readBody, sendJson |
| 24 | `/api/assistant/notes` | GET | 3125–3132 | 8 | assistant, sendJson |
| 25 | `/api/assistant/notes` | POST | 3133–3142 | 10 | assistant, authorised, config, readBody, sendJson |
| 26 | `/api/assistant/check` | POST | 3146–3150 | 5 | assistant, authorised, config, sendJson |

### 5.3 pipelines — 2 routes, 77 body lines, 2 blocks in 1 region

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/pipelines` | GET | 2476–2491 | 16 | EXIT_CHECKS, PIPELINE_KINDS, pipelines, PIPELINES_VERSION, sendJson |
| 2 | `/api/pipelines` | PUT | 2503–2563 | 61 | authorised, config, EXIT_CHECKS, log, PIPELINE_KINDS, pipelines, PIPELINES_VERSION, readBody, readPipelinesFile, sendJson, validatePipelinesDocument |

### 5.4 todos — 2 routes, 38 body lines, 2 blocks in 1 region

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/todos` | GET | 3928–3933 | 6 | path, sendJson, todos |
| 2 | `/api/todos` | POST | 3935–3966 | 32 | authorised, broadcastTodos, path, readBody, sendJson, todos, todoSay |

### 5.5 approvals — 4 routes, 24 body lines, 4 blocks in 1 region

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/approvals` | GET | 3895–3897 | 3 | approvals, sendJson |
| 2 | `/api/approvals` | POST | 3899–3909 | 11 | approvals, authorised, config, log, readBody, sendJson |
| 3 | `/api/approvals/answer` | POST | 3911–3916 | 6 | approvals, authorised, config, readBody, sendJson |
| 4 | `/api/approvals/*` | GET | 3918–3921 | 4 | approvals, sendJson |

### 5.6 settings — 25 routes, 318 body lines, 25 blocks in 3 regions

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/settings/sessions` | GET | 2425–2427 | 3 | sendJson, sessionSettings |
| 2 | `/api/settings/skills` | GET | 2437–2447 | 11 | hermesHome, jobs, path, readSkillsIndex, registry, sendJson |
| 3 | `/api/settings/permissions` | GET | 2455–2468 | 14 | CONFIG_PATH, HERE, hermesHome, jobs, path, readPermissions, sendJson |
| 4 | `/api/settings/sessions` | POST | 2565–2589 | 25 | authorised, config, log, readBody, sendJson, SESSION_LIST_MAX, SESSION_LIST_MIN, sessionSettings, writeSessionListLimit |
| 5 | `/api/settings/approvals` | GET | 2591–2593 | 3 | approvalState, jobs, sendJson |
| 6 | `/api/settings/approvals` | POST | 2595–2620 | 26 | APPROVAL_TIMEOUT_MAX, APPROVAL_TIMEOUT_MIN, approvalState, authorised, config, jobs, log, readBody, sendJson, writeApprovalTimeout |
| 7 | `/api/settings/provider` | GET | 2625–2627 | 3 | providerState, sendJson |
| 8 | `/api/settings/provider` | POST | 2629–2652 | 24 | authorised, config, log, providerState, readBody, sendJson, writeProviderSettings |
| 9 | `/api/settings/provider/profiles` | GET | 2664–2666 | 3 | listProfiles, sendJson |
| 10 | `/api/settings/provider/profiles` | POST | 2668–2684 | 17 | authorised, config, listProfiles, log, readBody, saveProfile, sendJson |
| 11 | `/api/settings/provider/profiles/delete` | POST | 2686–2703 | 18 | authorised, config, deleteProfile, listProfiles, log, readBody, sendJson |
| 12 | `/api/settings/provider/apply` | POST | 2707–2731 | 25 | authorised, config, log, profileWithKey, providerState, readBody, sendJson, writeProviderSettings |
| 13 | `/api/settings/matrix` | GET | 2740–2742 | 3 | matrixBridge, sendJson |
| 14 | `/api/settings/matrix` | POST | 2749–2768 | 20 | authorised, config, log, matrixBlock, matrixBridge, matrixPatchFrom, patchPanelConfig, readBody, sendJson |
| 15 | `/api/settings/matrix/start` | POST | 2770–2775 | 6 | authorised, config, matrixBridge, sendJson |
| 16 | `/api/settings/matrix/stop` | POST | 2777–2782 | 6 | authorised, config, matrixBridge, sendJson |
| 17 | `/api/settings/matrix/test` | POST | 2784–2790 | 7 | authorised, config, matrixBridge, sendJson |
| 18 | `/api/models` | GET | 2797–2801 | 5 | config, hermesHome, modelCatalogue, sendJson, warmModelPrices |
| 19 | `/api/models/refresh` | POST | 2809–2822 | 14 | authorised, config, hermesHome, jobs, log, refreshModelCatalogue, sendJson |
| 20 | `/api/visible` | POST | 4711–4720 | 10 | authorised, config, readBody, registry, scheduler, sendJson |
| 21 | `/api/settings/scan` | POST | 4724–4740 | 17 | authorised, broadcast, config, log, patchPanelConfig, readBody, scheduler, sendJson, settingsOut, snapshot |
| 22 | `/api/settings/cleanup` | POST | 4749–4762 | 14 | authorised, broadcast, config, log, patchPanelConfig, readBody, sendJson, settingsOut |
| 23 | `/api/settings/chart-top` | POST | 4768–4781 | 14 | authorised, broadcast, chartTopCountFrom, config, log, patchPanelConfig, readBody, sendJson, settingsOut, snapshot |
| 24 | `/api/settings/collapse-after` | POST | 4788–4801 | 14 | authorised, broadcast, collapseAfterSecondsFrom, config, log, patchPanelConfig, readBody, sendJson, settingsOut |
| 25 | `/api/settings/columns` | POST | 4807–4822 | 16 | authorised, broadcast, chartColumnsFrom, config, log, patchPanelConfig, readBody, sendJson, settingsOut |

Rows 9–11 also close over the dispatcher-level `profilesFile` (§2), which is not in the seam column because
it is not a module-level name.

### 5.7 panel-io — 7 routes, 164 body lines, 7 blocks in 4 regions

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/paths/open` | POST | 3331–3356 | 26 | authorised, config, ensureDirs, log, openerForFolder, path, readBody, sendJson, spawn |
| 2 | `/api/scratch/clean` | POST | 3363–3391 | 29 | authorised, broadcast, cleanScratch, config, CONFIG_DIR, HERE, homedir, humanBytes, jobs, log, path, pathsInfo, registry, sendJson, sizeOf, snapshot |
| 3 | `/api/cleanup` | GET | 3397–3412 | 16 | config, jobs, path, registry, sendJson |
| 4 | `/api/deliverables` | GET | 3887–3889 | 3 | deliverables, sendJson |
| 5 | `/api/open-url` | POST | 4827–4843 | 17 | authorised, config, log, openerFor, readBody, safeUrl, sendJson, spawn |
| 6 | `/api/deliverables/open` | POST | 4850–4901 | 52 | authorised, chromeFor, config, deliverables, log, openerFor, path, readBody, sendJson, spawn, stat |
| 7 | `/api/open-path` | POST | 4952–4972 | 21 | authorised, config, editorFor, path, readBody, sendJson, spawn, stat |

### 5.8 projects — 11 routes, 232 body lines, 11 blocks in 4 regions

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/hosts` | GET | 3419–3426 | 8 | hosts, registry, sendJson |
| 2 | `/api/hosts/propose` | POST | 3428–3440 | 13 | authorised, config, gitIn, hosts, path, proposeMapping, readBody, registry, sendJson |
| 3 | `/api/hosts/mapping` | POST | 3442–3470 | 29 | authorised, broadcast, config, hosts, hostsFile, log, readBody, registry, sendJson |
| 4 | `/api/steward` | GET | 3476–3481 | 6 | config, parents, readPlan, sendJson |
| 5 | `/api/steward` | POST | 3483–3492 | 10 | authorised, config, log, parents, readBody, sendJson, stewardProject, writePlan |
| 6 | `/api/steward/apply` | POST | 3496–3522 | 27 | applyPlan, authorised, broadcast, config, log, path, readBody, readPlan, sendJson, snapshot, stewardProject, stewardWorktrees |
| 7 | `/api/parents` | GET | 3864–3867 | 4 | parents, sendJson |
| 8 | `/api/repo/first-commit` | POST | 4265–4299 | 35 | authorised, config, gitIn, log, normPathKey, path, readBody, registry, sendJson, stat |
| 9 | `/api/clone` | POST | 5395–5428 | 34 | authorised, broadcast, config, gitIn, log, path, readBody, registry, sendJson, snapshot, stat |
| 10 | `/api/project/new` | POST | 5434–5488 | 55 | authorised, broadcast, config, gitIn, log, path, readBody, registry, rm, sendJson, snapshot, stat, writeFile |
| 11 | `/api/fetch` | POST | 5490–5500 | 11 | authorised, config, readBody, scheduler, sendJson |

### 5.9 worktrees — 7 routes, 350 body lines, 7 blocks in 2 regions

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/worktree/lock` | POST | 3156–3191 | 36 | authorised, broadcast, config, locks, log, normPathKey, path, readBody, scheduler, sendJson, snapshot, store |
| 2 | `/api/worktree/assistant` | POST | 3213–3246 | 34 | assistant, assistantForRow, authorised, broadcast, config, DEFAULT_OWNER, locks, log, normPathKey, ownerFields, pageCaller, path, readBody, scheduler, sendJson, snapshot, store |
| 3 | `/api/worktree/transfer` | POST | 3256–3321 | 66 | assistant, assistantForRow, authorised, broadcast, config, locks, log, normPathKey, ownerFields, pageCaller, path, readBody, scheduler, sendJson, snapshot, store |
| 4 | `/api/worktree/child` | POST | 3535–3612 | 78 | authorised, broadcast, cutChildWorktree, guard, jobs, log, normPathKey, parents, path, readBody, registry, scheduler, sendJson, snapshot, store, treeKey, treeNames |
| 5 | `/api/worktree/rollup` | POST | 3619–3654 | 36 | authorised, broadcast, config, log, normPathKey, parents, parentWorktreeOf, path, readBody, registry, rollGate, rollUp, sendJson, snapshot, stewardWorktrees, store |
| 6 | `/api/worktree/rebase` | POST | 3663–3746 | 84 | authorised, broadcast, config, locks, log, normPathKey, ownCopyOf, path, pool, readBody, rebaseKey, rebaseWorktree, registry, scanWorktree, scheduler, sendJson, snapshot, spawnFeature, stat, store, worktreeList, writerLocks |
| 7 | `/api/worktree/parent-question` | POST | 3750–3765 | 16 | authorised, log, normPathKey, path, questions, readBody, registry, sendJson, store |

### 5.10 remote-writes — 9 routes, 235 body lines, 9 blocks in 1 region

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/remote-write/state` | GET | 3970–3978 | 9 | CONFIG_PATH, DEFAULT_POLICY, guardReport, POLICIES, remoteWrites, sendJson |
| 2 | `/api/remote-write/report` | POST | 3985–4003 | 19 | authorised, cleanPath, config, readBody, remoteWrites, sendJson, spawnFeature |
| 3 | `/api/remote-write/request` | POST | 4010–4062 | 53 | authorised, cleanPath, config, log, path, policyForProject, readBody, remoteWrites, sendJson, spawnFeature |
| 4 | `/api/remote-write/status` | GET | 4065–4072 | 8 | remoteWrites, sendJson |
| 5 | `/api/remote-write/answer` | POST | 4077–4097 | 21 | authorised, config, log, readBody, remoteWrites, sendJson |
| 6 | `/api/remote-write/review` | POST | 4100–4105 | 6 | authorised, config, readBody, remoteWrites, sendJson |
| 7 | `/api/remote-write/unwind` | POST | 4112–4163 | 52 | authorised, config, execP, gitIn, log, readBody, remoteWrites, sendJson, stat |
| 8 | `/api/settings/remote-branches` | POST | 4167–4188 | 22 | authorised, config, guardReport, POLICIES, readBody, sendJson, setRemotePolicy, settingsOut |
| 9 | `/api/remote-write/guard` | POST | 4193–4237 | 45 | authorised, cleanPath, config, guardRecord, guardReport, installGuardFor, log, normPathKey, normTree, path, readBody, registry, scheduler, sendJson, spawnFeature, store, uninstallGuard, writeGuardRecord |

### 5.11 landing — 5 routes, 335 body lines, 5 blocks in 3 regions

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/worktree/pipeline` | POST | 3777–3862 | 86 | authorised, changePipeline, config, jobs, log, path, PIPELINE_SWITCH_STARTS_TURN, pipelineRecords, pipelines, presumedPipeline, readBody, sendJson, storeSwitch |
| 2 | `/api/worktree/delete` | POST | 4930–4949 | 20 | authorised, broadcast, config, deleteWorktreeRow, jobs, locks, log, path, readBody, scheduler, sendJson, snapshot, store |
| 3 | `/api/worktree/merge` | POST | 5142–5277 | 136 | authorised, broadcast, config, gitIn, hosts, isLiveJobStatus, jobs, locks, log, makeThreadName, mergeLabel, mergePrompt, normPathKey, path, policyForProject, readBody, registry, remoteWrites, scanWorktree, sendJson, spawnFeature, stat, worktreeList |
| 4 | `/api/worktree/verify-landed` | POST | 5289–5368 | 80 | authorised, config, gitIn, isLiveJobStatus, jobs, locks, log, makeThreadName, normPathKey, path, readBody, registry, scanWorktree, sendJson, spawnFeature, stat, tmpdir, verifyLabel, verifyPrompt, worktreeList |
| 5 | `/api/worktree/rename` | POST | 5376–5388 | 13 | authorised, config, describeNaming, path, readBody, renameWorktree, sendJson |

### 5.12 conversations — 17 routes, 406 body lines, 17 blocks in 4 regions

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/agents/preview` | POST | 4239–4243 | 5 | authorised, config, readBody, sendJson, spawnFeature |
| 2 | `/api/agents` | POST | 4245–4259 | 15 | authorised, config, jobs, readBody, sendJson, spawnFeature |
| 3 | `/api/attachments` | POST | 4304–4335 | 32 | authorised, config, log, mkdir, path, readRawBody, sendJson, writeFile |
| 4 | `/api/threads/model` | POST | 4337–4343 | 7 | authorised, config, jobs, readBody, sendJson |
| 5 | `/api/threads/context` | POST | 4345–4351 | 7 | authorised, config, jobs, readBody, sendJson |
| 6 | `/api/agents/reply` | POST | 4353–4379 | 27 | assistant, ASSISTANT_THREAD, authorised, config, readBody, sendJson, startThreadReply |
| 7 | `/api/thinking` | GET | 4467–4481 | 15 | authorised, config, hermesHome, path, sendJson, thinkingFor |
| 8 | `/api/tool-results` | GET | 4483–4507 | 25 | authorised, config, hermesHome, path, sendJson |
| 9 | `/api/subagents/collect` | GET | 4509–4522 | 14 | authorised, collectPrompt, config, hermesHome, path, sendJson |
| 10 | `/api/subagents/console` | GET | 4524–4531 | 8 | authorised, childTranscript, config, hermesHome, path, sendJson |
| 11 | `/api/tool-calls` | GET | 4536–4566 | 31 | authorised, config, hermesHome, jobs, path, sendJson |
| 12 | `/api/subagents` | GET | 4568–4577 | 10 | authorised, config, hermesHome, path, sendJson, subagentRoster, subagentsFor |
| 13 | `/api/sessions` | GET | 4579–4594 | 16 | cleanPath, jobs, path, sendJson, sessionsForRow |
| 14 | `/api/sessions/revive` | POST | 4596–4632 | 37 | authorised, cleanPath, config, hermesSessionTail, jobs, log, normPathKey, path, readBody, registry, sendJson, sessionsForRow |
| 15 | `/api/refresh` | POST | 4698–4705 | 8 | authorised, config, scheduler, sendJson |
| 16 | `/api/refresh/row` | POST | 4983–5109 | 127 | authorised, broadcast, config, descriptions, gitIn, isLiveJobStatus, jobs, liveRunIn, log, mergeDelta, normaliseRefreshAgent, ownerOnRow, parseCommitFiles, path, pool, readBody, REFRESH_LINES_SHOWN, refreshLog, scheduler, sendJson, startRowRefreshAgent, store, todoProposals, todos |
| 17 | `/api/refresh/row/agent` | POST | 5115–5136 | 22 | authorised, broadcast, config, path, readBody, refreshLog, scheduler, sendJson, snapshot, startRowRefreshAgent, store |

### 5.13 jobs — 11 routes, 142 body lines, 11 blocks in 4 regions

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/jobs` | GET | 3879–3882 | 4 | config, jobs, sendJson |
| 2 | `/api/jobs/cancel` | POST | 4381–4385 | 5 | authorised, config, jobs, readBody, sendJson |
| 3 | `/api/jobs/steer` | POST | 4389–4408 | 20 | authorised, config, jobs, readBody, sendJson, STEER_GONE, STEER_PARKED, STEER_PAST_BOUNDARY |
| 4 | `/api/jobs/reattach` | POST | 4414–4423 | 10 | authorised, config, gonePointers, jobs, readBody, sendJson |
| 5 | `/api/jobs/ask-complete` | POST | 4430–4438 | 9 | assistant, authorised, config, readBody, sendJson |
| 6 | `/api/jobs/approve` | POST | 4442–4449 | 8 | authorised, config, jobs, readBody, sendJson |
| 7 | `/api/jobs/answer` | POST | 4454–4459 | 6 | authorised, config, jobs, readBody, sendJson |
| 8 | `/api/jobs/attach` | POST | 4634–4664 | 31 | authorised, broadcast, config, gitIn, jobs, path, readBody, sendJson, stat |
| 9 | `/api/jobs/label` | POST | 4666–4677 | 12 | authorised, config, jobs, readBody, sendJson |
| 10 | `/api/jobs/clear` | POST | 4679–4696 | 18 | authorised, broadcast, config, jobs, readBody, sendJson |
| 11 | `/api/jobs/artifact/delete` | POST | 4905–4923 | 19 | authorised, config, jobs, path, readBody, sendJson, unlink |

### 5.14 spine (stays in server.js) — 5 routes, 58 body lines

| # | Path | Method | Lines | Body | Seam |
|---|---|---|---|---|---|
| 1 | `/api/reload` | POST | 5502–5524 | 23 | authorised, bootConfigJson, bootPass, bootPassCanSatisfyReload, bootPassFinishedAt, broadcast, config, jobs, loadConfig, pool, Pool, readBody, registry, scheduler, Scheduler, seedTreeName, sendJson, snapshot, store, sweepCheckedLandings, sweepReleases |
| 2 | `/api/restart` | GET | 5531–5533 | 3 | restart, sendJson |
| 3 | `/api/restart` | POST | 5535–5551 | 17 | assistant, authorised, config, log, readBody, REASON_REQUIRED, restart, sendJson |
| 4 | `/api/restart/cancel` | POST | 5556–5569 | 14 | authorised, config, log, readBody, restart, sendJson |
| 5 | `/api/stream` | any | 5571–5571 | 1 | clients, handleStream, snapshot |

---

## 6. The mount, and the one file each extraction still touches

### 6.1 The mount

After the seam landing, `server.js` keeps one router call and one table. The table sits where the boot pass is
declared, after the last store exists (2,370 is the current anchor), and the handler gets one line where the
three factory mounts are today:

```js
// server.js, before createServer
const routes = createRoutes({
  queue:         queueRoutes,
  pipelineWindow: pipelineWindowRoutes,
  pipelineCatalogue: pipelineCatalogueRoutes,
  system:        createSystemRoutes({ getConfig, getPool, getScheduler, build, clients, jobs, registry, store, settingsOut, snapshot }),
  assistant:     createAssistantRoutes({ assistant, element, jobs, getConfig, broadcast, sendJson, readBody, authorised, saveProfile }),
  // … one entry per group
});

// inside the handler, where 2,388–2,394 are today
if (await routes(req, res, route, url)) return;
```

`lib/routes/index.js` owns the mechanism — ordering, the duplicate assertion, the one handler — while the
wiring stays in `server.js`, because only the composition root can hand over the state:

```js
export function createRoutes(groups) {
  const handlers = Object.values(groups).filter(Boolean);
  // A duplicate path is a boot error, not a route that never runs: the first module
  // to claim a path wins today, silently. Build the claim map once, here.
  const claims = new Map();
  // A claim is "METHOD /path" — a GET and a POST of one path are two claims, and the
  // five blocks that test no method claim "ANY /path". A path claimed twice under one
  // method is the bug this catches.
  for (const h of handlers) for (const c of h.claims || []) {
    if (claims.has(c)) throw new Error(`${c} is claimed by ${claims.get(c)} and ${h.name}`);
    claims.set(c, h.name);
  }
  return async function routes(req, res, route, url) {
    for (const handle of handlers) if (await handle(req, res, route, url)) return true;
    return false;
  };
}
```

The duplicate check needs each factory to publish its claims (``handle.claims = ["GET /api/…"]``) or the
router to take `{ claims, handle }` pairs. Either is a two-line convention; it is worth it because the partition in §5 is
exactly the property that makes the thirteen extractions independent, and a boot-time assertion is how that
property stays true after the first worker edits a guard.

### 6.2 The one file

**Every extraction still touches `server.js`.** That is the honest answer to the brief's "the ONE file": the
route code being extracted is *in* `server.js`, so it must be deleted from `server.js`, and the group's factory
must be added to the mount table *in* `server.js`. A group's edit is:

- **N block deletions**, in the regions §4 gives (2 to 25 blocks per group, 1 to 4 regions);
- **one mount-table entry** — the factory call and its argument object.

The deletions are disjoint by construction: the groups partition the 136 conditions, no condition is in two
groups, and no group's moved helper is moved by another. The mount table is the only shared hunk: every
extraction inserts at the same place, so two extractions' diffs do not conflict *textually* except there. Git
would merge the deletions; the panel will not run two of them together, because `server.js` is one lane
(`lanes-and-modules.md` §1 and §9). That is a queue rule, not a merge rule, and it is the reason §7 is an
order rather than a fan-out.

**The alternative that removes that shared hunk, and why it is rejected.** One landing could move the whole
dispatcher — all 136 blocks, 3,176 lines — into `lib/routes/index.js` in a single commit, with `server.js`
left holding one mount. After that, a group extraction would never touch `server.js`; it would edit only
`lib/routes/index.js` (delete its blocks, add its entry) and create its file. That is a real improvement in the
collision surface, and it is the wrong first step: it puts 3,176 lines and 465 `reply` rewrites in one diff,
with no incremental proof, no boot between groups, and a review that cannot be read. The lane rule would still
serialise the group cuts, because `index.js` is then the one file they all edit. Thirteen small moves with a
provable pure-move invariant (§8) beat one unprovable big one; the mount table costs one extra hunk per group
and buys thirteen landings that can each be reverted on their own.

The header band is edited by exactly two kinds of landing: the seam landing (it adds the `createRoutes` call
and the three getters) and the helper moves listed in §4 (`editorFor`, `stewardProject`, `sessionsForRow`,
`refreshAgentPrompt`, `startRowRefreshAgent`, `gonePointers`). Each of those helpers is called by exactly one
group's routes, which is why it can move with that group and with nothing else.

### 6.3 The size after the cut

| | Lines |
|---|---|
| today | 5,833 |
| the dispatcher, first condition to last — the 136 blocks and the comments between them (measured: 3,176) | −3,176 |
| moved helpers (§4.7, 4.8, 4.12, 4.13; measured) | −112 |
| the mount table: 13 groups plus the 3 existing handlers (estimate: ~45 wrapped lines) | +45 |
| the three factory mounts, replaced by one router line | −6 |
| **after all thirteen** | **≈2,584** |

The remaining ≈2,584 lines are the 2,377-line composition root minus the 112 moved helper lines, plus the
mount table, the 244-line tail and a handler of about 30 lines. A route split that stops there has removed 56%
of the file and left one handler.

---

## 7. What can run in parallel, and the extraction order

### 7.1 The rule

Two facts decide every answer:

1. **Landing is serial.** Every extraction edits `server.js`; `server.js` is one lane. The panel's queue will
   order any two rows that claim it (§1 of `lanes-and-modules.md`), so no two extractions *land* together.
2. **Authoring can be parallel** when two groups share no helper that is being moved and no region that is
   being deleted. That is true for most pairs after the seam exists.

So "can run in parallel" below means **can be written in separate worktrees at the same time without one
worker's decision changing the other's factory signature**. It does not mean "can land together".

### 7.2 The waves

| Wave | Groups | Parallel? | Why this position |
|---|---|---|---|
| 0 | seam + **system** | alone | installs `lib/routes/index.js`, the `reply` convention, the three getters and the one mount. Five reads, 25 lines — the smallest possible proof of the contract. Nothing else may start until this lands. |
| 1 | **assistant** | alone | 26 routes in one contiguous region, five hand-ins, no helper. Proves a large block moves without touching the header. |
| 2 | **pipelines**, **todos**, **approvals** | **yes, 3 at once** | 8 routes, 139 body lines between them, disjoint regions (2,476–2,563; 3,928–3,966; 3,895–3,921), no shared helper. These three can be authored in one wave and landed in any order; wave 4 is the other parallel wave. |
| 3 | **settings** | alone | 25 blocks in 3 regions, the shared `profilesFile` local, and the getters that must be read per request. One worker, one file, the largest hunk count. |
| 4 | **panel-io**, **projects** | **yes, 2 at once** | each moves exactly one route-only helper (`editorFor`; `stewardProject`); their regions are adjacent but disjoint (3,331–3,412 vs 3,419–3,522, and 3,887–3,889 vs 3,864–3,867). |
| 5 | **worktrees** | alone | 19 hand-ins, two regions, and the only two `pageCaller` routes. Nothing shared with wave 4, but the widest middle seam. |
| 6 | **remote-writes** | alone | fixes the decision about the guard helpers: they stay in the spine and are handed in (§4.10). Landing depends on that decision, so it must land before wave 7. |
| 7 | **landing** | alone, after 6 | the widest seam (17 hand-ins, 22 re-imports) and the highest-risk behaviour: merge, verify-landed, delete, rename. It should move after the pattern has been proven six times. |
| 8 | **conversations** | alone | owns the three refresh helpers it moves and the 127-line `/api/refresh/row`; it is the largest body (406 lines). |
| 9 | **jobs** | alone, after 8 | 11 small routes, but it hands in `assistant` and edits four regions that interleave with conversations'. Landing it last means every helper home is settled before the smallest seam gets cut. |

Waves 2 and 4 are the only genuinely parallel ones. Waves 0, 1, 3, 5–9 are single-worker waves: each either
installs a convention, moves a helper, or edits the largest block in the file, and a second worker in the same
wave would be guessing at the first worker's signature.

### 7.3 The pairs that cannot be parallel even in authoring

- **remote-writes + landing** — both call `guardRecord`, `installGuardFor`, `refreshGuards`, `guardReport` and
  `setRemotePolicy`, and both read `remoteWrites` and `policyForProject`. The recommendation is in §4.10: keep
  the five in the spine and hand them in. If a worker instead moves them to `lib/guard-record.js`, that move
  must be its own landing before either group, and the other group rebases onto it.
- **conversations + jobs** — both use `jobs`, `assistant` and `broadcast`; conversations moves
  `startRowRefreshAgent`, jobs moves `gonePointers`. They do not share a moved helper, but they share the
  `assistant` and `jobs` objects, and conversations hands in `startThreadReply`. Landing jobs after conversations (§7.2)
  keeps the last decision in one worker's hands.
- **settings + system** — both use `settingsOut` and `snapshot`, but both get them from the spine. No conflict;
  the reason they are not in one wave is size, not seam.

---

## 8. Verifying one extraction

A route extraction is a **pure move** plus a small set of mechanical edits. It can be proved, not just
tested:

1. **The move is byte-identical.** For each block in the group, take the current text
   (`git show <base>:server.js | sed -n 'A,Bp'`), apply `s/return sendJson(/return reply(/`, and compare with
   the new module's corresponding lines. The only allowed differences are that substitution and the module's
   own wrapper lines. `git diff --color-moved=blocks` shows the rest as moves, not edits.
2. **No `return sendJson(` remains** in the new module: `grep -c "return sendJson(" lib/routes/<group>.js` is 0.
3. **Auth is unchanged.** Every moved block that called `authorised(req, config.token)` calls
   `authorised(req, getConfig().token)` — same test, same token, per request. A grep of the old block's
   `authorised(` count against the new module's is the check. Do not add auth to the 29 GETs that have none:
   reads are open by design on loopback. The six GETs that *do* check it (`/api/thinking`, `/api/tool-results`,
   `/api/tool-calls`, `/api/subagents`, `/api/subagents/collect`, `/api/subagents/console`) keep their check
   exactly as it is — adding or removing one is a behaviour change, not a move.
4. **`node --check`** the new module, then `npm test` (168 files). The suite is the gate; the route modules are
   pure movement, so a red test is a move error, not a design question.
5. **Boot and smoke.** `node server.js` against a throwaway `PANEL_CONFIG`, then request every path the group
   claims with its method, plus one wrong method. Every moved path must answer with its old status; no moved
   path may 404 or hit `serveStatic`.
6. **The inventory.** After the extraction, the router's registered paths must equal the paths deleted from
   `server.js`. §5's table is the checklist: 137 inline paths, of which the spine keeps four (`/api/reload`,
   `/api/restart`, `/api/restart/cancel`, `/api/stream`); a group's registered set must be exactly its rows in
   §5. The duplicate check in §6.1 enforces the other direction at boot.

---

## 9. What this page found but did not fix

- **Five routes accept any method** — `/api/health`, `/api/config`, `/api/state`/`/api/audit`, `/api/stats`.
  They are reads by convention, but a POST to `/api/config` runs the same block. It is a two-line fix per
  route and it belongs in the extraction of `system`, not before it.
- **`profilesFile` is a dispatcher local** (2,662) shared by three routes — the only cross-block local in the
  file (§2).
- **`/api/reload` rebinds three spine values** (5,512–5,516). Any module handed `config`, `pool` or `scheduler`
  by value goes stale on the first reload; the getters are not optional.
- **465 `return sendJson(` sites** in the route blocks. The `reply` rewrite is the single largest mechanical
  change in the whole split, and the easiest one to get wrong in a way the happy-path tests do not see (the
  response is correct; the handler then falls through to static and throws).
- **`renameWorktree` is 370 lines and two callers** — the rename route and the assistant's `onRename`. It is
  the biggest helper in the header and the obvious next extraction, but it is not a route module.

---

## 10. What this page did not do

- **No code moved.** Every line number is measured at `e2358c5`; nothing in `server.js` or `lib/` changed.
- **No tests run.** `npm test` is the gate for each extraction, not for this page.
- **No branch created, no push, no PR.** This is a research commit under `docs/reviews/` only.
- **No measurement of runtime cost.** The split changes no request path; latency, memory and the SSE frame
  rate are outside this page (`../arch-review-efficiency.md` owns them).
- **No decision about the composition root** beyond "it stays". `snapshot`, the guard record and
  `renameWorktree` are the three candidates for a second cut; each has more than one non-route caller.

---

## Appendix A — re-measuring this page

Everything below was run at `e2358c5` from the worktree root. The matcher was a throwaway script; the
commands and the definition of a seam are the reproducible part.

```sh
# the file, and the two anchors
wc -l server.js                                   # 5833
grep -n "const server = createServer" server.js   # 2378

# every dispatch condition, with its span and method:
#   a brace matcher over lines 2378–5589 that starts at /^    if \(/
#   and keeps the condition when it names route or url.pathname
# → 136 blocks: 135 with `route ===` (one carrying two paths) + 1 prefix

# the seam of one block: the identifiers inside its span — including the
# ${…} expressions of template literals, whose text is not an identifier —
# intersected with the module-level names (imports + const/let/function at
# column 0, plus the destructured globalThis.wtSteerable names at line 100)
# → the tables in §5

# the mounted module paths
grep -n 'route !== "/api' lib/assistant/queue.js lib/pipeline-window.js lib/task-pipeline-assign.js

# the sizes §10 already measured, re-checked by hash, not re-counted:
git rev-parse HEAD:server.js origin/main:server.js   # the same blob
git diff --stat HEAD origin/main -- lib public        # empty
```

The block spans in §5 are 1-based, inclusive, and were produced by matching the `if` line to its closing brace
with strings and line comments skipped. A block that is a single `if (…) return …;` is one line; only
`/api/stream` is. The four "any" blocks in `system` (five paths) and the one in `spine` are the only blocks with
no `req.method` test.
