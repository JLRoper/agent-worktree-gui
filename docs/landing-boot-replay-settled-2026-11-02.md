# A boot replay settled the debt — and then cut the tree anyway (0.60.1)

Read on branch `wtgui/task-13-216-0-59-0-was-s-9d2af6`, cut from `main` at `7a9959a` (0.60.0), on 2026-11-02 at
`date` 06:14 EST / `date -u` 11:14Z. The starting tree carried no commits of its own (`git rev-list --left-right
--count origin/main...HEAD` → `0 0`).

**Answer: `judgeLanded` DID answer "settle" for all three debts — the 0.59.0 boot journalled three
`replay skipped: already landed` lines at 10:44:58.691, .695 and .698 — and the panel cut a fresh tree for one of them
ten seconds later anyway. The field that kept the debts owed was `tree: null`: three of the five records had never
recorded a worktree at all, and the fourth named a leftover directory. The hole was not the verdict, it was that the
CARRY-OUT path never read it: `applyActions` started whatever SPAWN line it was handed, so a debt settled as landed
was carried a second time by a re-harvest of the same turn and cut `git worktree` at `df3b95d`.**

## 1. The debts, as the live store carries them

`logs/assistant.json` here means the panel instance's own store (`C:/Users/roper/.wag/state/assistant.json`, 60
`spawnIntents`, `savedAt` 2026-11-02T10:54:18Z). The repo's `logs/assistant.json` is a stale copy from 2026-10-28 and
does not contain these turns.

Verdicts below are `judgeLanded` from this branch's `lib/assistant/landed.js`, driven over each record's own
`tree`/`branch` exactly as `skipLandedReplays` computes them (`tree || (existing ? target : "")`):

| debt | turn | target / recorded tree | judgeLanded today | what kept it owed |
|---|---|---|---|---|
| `065afb5b` | `c8e5a72d` | `agent-worktree-gui`, tree **null at the boot** | `gone: true` — "its tree is gone" (the tree it carries now, `…/task-1-make-the-queue-ro-2d2c78`, is the replay's) | no worktree recorded |
| `68454c34` | `14232f9a` | `existing: true`, `…/make-queue-row-a-real-console-row-b63717` | `gone: true` — "its tree is a leftover directory — git answers for `C:/ProjectDevelopment/agent-worktree-gui` there" | a tree path that resolves to the primary checkout |
| `b4c98d32` | `14232f9a` | `agent-worktree-gui`, no tree | `gone: true` — "it names no tree at all" | no worktree recorded |
| `825fa68e` | `06d54ded` | `agent-worktree-gui`, no tree | `gone: true` — "it names no tree at all" | no worktree recorded |
| `139a4ca9` | `7115508a` | `agent-worktree-gui`, tree null at the boot | `gone: true` — "its tree is gone" | no worktree recorded |

Every one of them is a skip in its own right (`lib/assistant.js:3589`, `if (!verdict.landed && !verdict.gone) continue`).
None is "thread-only": the thread was recorded (`panel-assistant`) and is not what the verdict reads.

## 2. The ordering — settlement ran before the cut, and it did not matter

The 0.59.0 boot (serve `df3b95d`, restart wake journalled at 10:45:54):

- `10:44:58.691` `replay-skipped` — `065afb5b` settled: "it names no tree at all, so nothing was started".
  Same second, `.695` (`14232f9a`) and `.698` (`06d54ded`).
- `10:45:08.041` job `2dbf0e86`, thread `wtgui-remove-the-role-tab-project-90f99e`, cwd
  `…/.worktrees/remove-role-tab-whitelists-add-worktrees-e146d8`, `baseSha df3b95d`, cancelled at 10:45:22 (14 s).
- `10:45:08.063` job `6f092a51`, thread `wtgui-task-1-make-the-queue-row-a-02f64a`, cwd
  `…/.worktrees/make-queue-row-a-real-console-row-4-2d2c78`, `baseSha df3b95d`, cancelled at 10:45:22 (14 s).

Ten seconds after the skip, both were cut from the very commit that fixed #216. The debt records prove the order,
because `settleSpawnIntent` stamps `tree`/`branch` from the job it started:

- `065afb5b` reads `landedAt 10:44:58.691` / `landedWhy "it names no tree at all"` **and** `tree …2d2c78` /
  `branch wtgui/task-1-make-the-queue-ro-2d2c78` / `jobThread …02f64a` — the tree those fields name is the
  10:45:08 replay's, so the same record was settled and then carried.
- `139a4ca9` was written at 07:22:08 for job `…28ab05` in tree `remove-role-tab-proj-bdf617`; it now reads
  `jobThread …90f99e`, `tree …e146d8`, `branch wtgui/remove-the-role-tab-proj-e146d8` — the replay overwrote
  where the brief had gone, on a debt whose brief landed as #211.

So the answer to "is settlement reached before the tree is cut" is: **on this boot, yes — by ten seconds — and it
still cut both, because the two are not connected.** Settlement is bookkeeping written by a fire-and-forget pass on
the sentry's tick (`lib/assistant.js:1634`, throttled 60 s by `landedCheckAt`, skipped while a pass is in flight); the
tree is cut by `applyActions` from a harvested SPAWN line, which never reads the debt. On an ordinary boot the pass
can also land *after* the digest is built, because the wake's preamble is composed synchronously when its turn starts
(`this.preamble(...)` → `digest()`, `lib/assistant.js:2761`).

## 3. What changed

- **`lib/assistant.js:3163` — a line already carried out is not carried out again.** `noteSpawnIntent` is keyed by
  turn + target + prompt, so an item it *returns* rather than creates is the same SPAWN line coming round again —
  which is what a boot does when it re-reads one of the assistant's old turns (`harvested` holds 50 turn ids,
  `lib/assistant/store-file.js:21`, so the oldest fall out and read as never harvested). The line is refused by name,
  journalled as `spawn-replay-refused` ("already landed — … so this line was not carried out again — write a new SPAWN
  line if the work still needs doing"), and the debt is left exactly as it was. A line written by a *new* turn is a new
  intent and is carried as before.
- **`lib/assistant.js:1558` — the restart wake settles first.** `wakeAfterRestart` is async and awaits
  `skipLandedReplays({ force: true })` (`lib/assistant.js:3558`) before it composes the wake text, so the digest the
  restart turn reads cannot advertise a debt whose work has already landed. The wake says how many it settled.
  `lib/restart.js:912` journals a rejection instead of leaving one unhandled.

Not changed: `judgeLanded`, `own-tree.js`, `spawn-target.js` — the 0.59.0 verdicts above are correct and stay.

## 4. The gate: a real debt, not a seeded one

`tools/verify-restart-idempotence.mjs` section **1c** replaces nothing and seeds nothing: it builds an `Assistant`
over the sandbox's own `logs/assistant.json`, has that assistant's `noteSpawnIntent` + `checkSpawns` record a SPAWN
line the way the watchdog records one for a turn that ended three minutes ago, asserts the panel's own `digest()`
advertises it under "SPAWN LINES THAT PRODUCED NOTHING", then boots the real panel over that store and asserts:

- the boot journals `replay skipped: already landed` naming `turn-real-debt`;
- no run was POSTed for the brief, and the debt reads `landed` on disk;
- the digest the next turn reads advertises none of it;
- the same turn read again is refused as `spawn-replay-refused`, and the settled debt is untouched.

**55 checks, 55 passed, 0 failed.** Red proof — the pre-fix `lib/assistant.js` (from `HEAD`) put back, same gate:
**54/55, one failure**, "…and the same turn read again is refused by name, not carried into a second tree", with the
journal showing the carry (`spawn-failed … unknown project: sandbox-repo`) where the refusal should be. Restored,
55/55 again.

`test/restart-idempotence.test.js` adds two unit tests (17 in the file, all green): the settled line is refused while a
new turn's identical words still start, and the restart wake has already settled the debt at the moment it is composed.

## 5. Version

0.60.1 — a patch over main's 0.60.0 (`node tools/version.mjs apply patch`). The change makes an existing rule bind and
reorders one boot step; nothing reader-visible is added beyond the refusal and settle lines, so the minor belongs to
whatever lands next.
