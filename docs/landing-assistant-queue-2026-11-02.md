# Every assistant's own task queue was already landed — record of the re-check

The brief asked for a per-assistant queue of work, a Queue sub-tab on each assistant, and a wake digest a turn can
read so it starts whatever can be parallelised. All eight items are on `main`: PR **#196** (`feat: give every
assistant its own task queue`) landed them at **`935bfc4`**, `0.53.0`, and this tree was cut from a `main` that
already carried them. Its TODO list was re-issued as eight `todo` rows; none of those rows was still open work.

Two follow-ups landed beside it while this tree was being re-checked, and both change how the same code reads today:

- **PR #202 / `2a0a96f` (0.54.0)** — the Queue pane stopped re-arming its own read (it was painting itself in a
  loop: 1 read on the first paint, 2 by 120 ms, 23 by 1.5 s), gained four explicit pane states, and every
  assistant's preamble gained the standing "drive your own queue" directive.
- **PR #203 / `75a89f4` (0.55.0)** — the assistant float became a docked right rail. The sub-tab row and its
  panes moved with it; the queue region is `public/assistant.js:1826-2024` today.

Against that landed code the brief's list verifies item by item — with **one gap that was still real**: item 8's
"browser check that the sub-tab renders all four markers" did not exist. `test/assistant-queue-ui.test.js` slices
the row renderer out of `public/assistant.js` and drives it with stubs: that pins HTML, but it never boots a panel,
never answers the route and never paints a row. This branch lands the gate that does, and the one store defect that
gate found (a second assistant created while the panel was running had no queue file until its first task).

## What is on main, and where it came from

```
git show 935bfc4:package.json | grep version  ->  "version": "0.53.0"
git merge-base --is-ancestor 935bfc4 origin/main  ->  true
git show --stat 935bfc4                            ->  12 files changed, 1620 insertions(+), 9 deletions(-)
git diff --stat 935bfc4 origin/main -- lib/assistant/queue.js lib/assistant/config.js  ->  empty
```

The queue module and its two config defaults have not moved since the landing; what moved is the page (the dock
rewrote it) and the preamble (the directive PR #202 added). The `file:line` anchors below are from `origin/main`
`75a89f4`, with a THEN/NOW table where the page moved.

## The shape it has, against the brief's list

- **1. Store, every assistant including #1.** `queueRelFor(id)` (`lib/assistant/queue.js:56`) resolves
  `assistants/<id>/queue.json` under the state directory — #1 is not special and there is no legacy layer, because
  there never was a queue. `loadQueues()` (`lib/assistant.js:828`) seeds one empty document per assistant at boot.
  The task shape is `pickTask` (`lib/assistant/queue.js:109`): `{id,title,detail,state,owner,createdBy,createdAt,
  startedAt,doneAt,doneBy,thread,worktree,files[],attempts,reason,movedFrom[]}`, capped at 200 and written
  atomically (tmp + rename, `:201`). `state` is one of `queued | running | parked | done`; stale and conflict are
  DERIVED at read time and never written.
- **2. Routes.** `createQueueRoutes` (`lib/assistant/queue.js:566`) is one module exporting one handler, mounted
  with one call at `server.js:1956`. `GET /api/assistant/queue?assistantId=` answers one assistant's queue; with no
  id it answers `{queues}` for every assistant. `POST` takes `add | edit | state | reassign | delete`; reassign
  records `movedFrom` on the task (`:344`), and delete removes the row rather than tombstoning it (`:366`).
- **3. Wake digest.** `queueDigest` (`lib/assistant/queue.js:469`) is the top `queueDigestSize` queued tasks
  (default 5), **every** running task with its thread, every stale one, and the parked ones with their reason.
  `queueDigestForTurn` / `queueDigestDue` (`lib/assistant.js:689`, `:699`) gate a WAKE by `queueSweepEveryNWakes`
  (default 1); a reader's own message always carries it. Both knobs are per-assistant settings
  (`lib/assistant/config.js:140-141`, scope `:189-190`, bounds `:258-259`) and the preamble appends the digest at
  `lib/assistant.js:2493`.
- **4. Staleness.** `runningFlag` (`lib/assistant/queue.js:426`) marks a running task stale when its recorded
  thread has no live run — or when it has no thread at all — and carries `staleWhy`. The digest prints
  `STALE: …` (`:486`); the pane prints `STALE — …` under the row and still draws the ●, so phantom work is named
  rather than shown as progress.
- **5. Eager completion.** `settleTasks` (`lib/assistant/queue.js:516`) is swept from the sentry
  (`lib/assistant.js:1555`): a settled `done` run whose row reads MERGED becomes `done` with `doneBy: "panel"` and
  stays in place; a failed/interrupted run returns to `queued` with `attempts + 1` and the reason; a `done` run
  whose PR is NOT merged stays running and stale, because landing, fixing or re-queueing is the assistant's call.
- **6. Parallelism guard.** `filesIntersect` / `intersectingFiles` (`lib/assistant/queue.js:87`, `:94`) match the
  same path or a parent directory, not a substring. `decorateTasks` (`:389`) marks a queued task whose files touch
  a running task's files with `conflict` and a `skipped` sentence naming the blocker (and whether it is stale); the
  digest prints `SKIP:` and the pane prints `SKIPPED — …`.
- **7. UI.** The Queue sub-tab is `public/index.html:582` with its pane at `:588`; the pane is
  `public/assistant.js:1826-2024`. `queueMark` (`:1843`) is ○ queued, ● running, ⏸ parked, ✓ done;
  `queueTaskHtml` (`:1849`) draws id, marker, title, owner, thread/PR/tree/files, the Move control (another
  assistant) and delete. A done row keeps its place and is greyed by `.as-task.is-done { opacity: .55 }`
  (`public/style.css:3014`).
- **8. Tests.** Unit: `test/assistant-queue.test.js` (22), `test/assistant-queue-ui.test.js` (6),
  `test/assistant-queue-pane.test.js` (6), `test/assistant-queue-directive.test.js` (4). The browser half is this
  branch's `tools/verify-assistant-queue.mjs` — see below.

### WHERE the page anchors moved (935bfc4 → 75a89f4)

| anchor | THEN | NOW |
|---|---|---|
| `// ---- the queue sub-tab` region | `public/assistant.js:1916` | `public/assistant.js:1826` |
| `queueMark` | `public/assistant.js:1928` | `public/assistant.js:1843` |
| `queueTaskHtml` | `public/assistant.js:1934` | `public/assistant.js:1849` |
| `renderAssistantQueue` | `public/assistant.js:1979` | `public/assistant.js:1921` |
| `.as-task` rule | `public/style.css:3025` | `public/style.css:3012` |
| `queueRoutes` mount | `server.js:1946` | `server.js:1956` |
| `queuePathOf` / `loadQueues` | `lib/assistant.js:605` / `:809` | `lib/assistant.js:624` / `:828` |

## What this branch adds

### 1. `tools/verify-assistant-queue.mjs` — the browser check item 8 names

62 checks, in five sections, over a panel booted by `tools/panel-testkit.mjs` (its own data directory, its own
scanned repo, a free port, a dead `apiServer` and `assistant.enabled: false`, so nothing can spawn a run). The live
board on 7331 is not touched and its listener count is compared before and after.

- **store:** `GET ?assistantId=assistant-1` answers 200, `found: true`, its `file` ends
  `/assistants/assistant-1/queue.json` and exists on disk; empty counts; the no-id list form.
- **routes:** four adds (ids 1–4, all `queued`), creator recorded, files normalised; `state` → running stamps
  `startedAt`, → parked keeps the reason, → done records `doneBy: "panel"`; `edit` changes the detail.
- **digest:** the header counts the four states and names the stale one; the queued task carries its owner, files
  and `SKIP: files in use by #2 (stale)`; the running task carries its thread and `STALE: that thread has no live
  run`; the parked task carries its reason; done work is a count, not a line.
- **a second assistant:** created over the route (201), its queue is `found: true`, same path shape, on disk; a
  reassign moves the owner and records `movedFrom: assistant-1 → assistant-2`; the task stays in #1's list.
- **browser (headless Chromium):** the session row's third sub-tab is `queue`/Queue; pressing it shows `#as-queue`,
  hides Chat and records `{"assistant":"assistant-1","subTab":"queue"}`; the pane names #1's own queue and offers
  its add form; four rows paint in state order with **● ○ ⏸ ✓** and their marker classes; the done row is greyed
  (`opacity .55`) and stays; titles, the running row's thread + STALE sentence, the queued row's files + SKIPPED
  sentence, the parked row's reason and the moved owner all read; every row offers Move and ✕; a real Move and a
  real ✕ are pressed and the route agrees; the pane spends no second read in 1.5 s after the paint; no page errors.

Red proofs (the numbers the commit body quotes):

- against **`e317798`** (`935bfc4^`, before the feature): **13 named FAILs, then the run aborts** —
  `TypeError: Cannot read properties of null (reading 'counts')` — exit 1. There is no route, no file and no
  sub-tab there, which is what "before" looks like.
- against **`75a89f4`** (main without this branch's fix): **62 checks, 2 failed** —
  `Assistant #2's queue is found too — not created on its first write` and `…and on disk`; exit 1.
- on the branch: **62 checks, 0 failed**, twice — once on `2a0a96f`, again on `75a89f4` after the dock landing.

### 2. A new assistant's queue file is seeded when it is created

`loadQueues()` seeded the assistants a boot found; `createAssistant()` did not seed the one it made, so
`GET /api/assistant/queue?assistantId=assistant-2` answered `found: false` until the first task was added — the
"created on first write" shape the queue's own comment rules out. `lib/assistant.js:1190` now writes the empty
document beside the new charter (best-effort: a read-only directory logs and carries on).
`test/assistant-queue.test.js` adds one test over a real `Assistant` and a temp state dir: #1's file exists at boot
and reads `found: true`; #2's exists at creation as `{version: 1, nextId: 1, tasks: []}`.

### Not this branch's work

The shipped sub-tab gate (`tools/verify-assistant-subtabs.mjs`) was red on `main` after the queue landing — it
still deep-equalled the sub-tab row to `["chat","settings"]`. That was repaired by **PR #202**'s sibling
`bb9b8eb`, and this branch does not touch it.

## Re-checked on this tree

`date` read `Mon, Nov  2, 2026 12:42:31 AM` EST / `date -u` `Mon, Nov  2, 2026  5:42:31 AM` UTC, from
`C:/ProjectDevelopment/agent-worktree-gui/.worktrees/give-every-assistant-its-07420f`. These numbers describe the
code this branch lands: it sits on `origin/main` `75a89f4` (0.55.0) and carries three commits on it
(`0 3` against `origin/main`).

- `npm test` → **801 tests, 801 pass, 0 fail, 0 cancelled, 0 skipped**, 69.4 s.
- `node --test test/assistant-queue.test.js` → **22 tests, 22 pass, 0 fail**.
- `node tools/verify-assistant-queue.mjs` → **62 checks, 0 failed** (`ASSISTANT-QUEUE-OK`), and the same gate on
  the parent is the 2-failure red proof above.
- `git rev-list --left-right --count origin/main...HEAD` → `0 0` before this branch's commits; `0 3` with them.
- `git status --porcelain` → empty.

## Version

`0.56.0`. Minor over `main`'s `0.55.0`: `docs/versioning.md` files **a new gate** as a minor — "a new harness that
enforces something … is a capability the repo did not have" — and this branch adds one. The brief asked for "the
next free minor at landing time (0.53.0 unless taken)": `0.53.0` was spent by PR #196, `0.54.0` by PR #202 and
`0.55.0` by PR #203, so the next free one is `0.56.0`. The seed fix is a patch on its own and rides this branch;
the branch's level is the higher of the two. The feature's own bump travelled with PR #196.
