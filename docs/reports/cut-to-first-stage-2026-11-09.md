# The cut-to-first-stage handoff: 0.853 s in round 6, 3 m 04.5 s in round 7

Round 7's review recorded the one number that got worse: the first worker waited **3 m 04.5 s** after its tree existed,
against **0.853 s** in round 6. The review's own note at the time said the figure was one sample and that "the row's
records carry the stamps but not the reason the spawn waited". This report gives the reason, from the panel's log, and
names the half of it that is a defect.

## The two rows

| round | tree cut (`pipelineRun.tree.cutAt`) | first stage asked (`stageRuns[0].at`) | wait |
|---|---|---|---|
| 6 | 2026-11-08T22:49:30.183Z | 2026-11-08T22:49:31.036Z | 0.853 s |
| 7 | 2026-11-08T23:57:09.145Z | 2026-11-09T00:00:13.655Z | 3 m 04.510 s |

The first job of round 7 (`5056fb50`) started at 00:00:14.733Z, 1.078 s after the ask — so the wait was not the
gateway, the spawner or the agent. It was entirely between "the tree exists" and "the panel asked for the stage".

## What was running, from the panel's own log

Every time below is from `logs/server.out.log`; the row and job stamps are from the queue and job stores.

| time | what | gap closed |
|---|---|---|
| 23:56:42 → 23:57:11 | Assistant #2's own turn (`ca896545`) was running while the cut was made | — |
| 23:57:07 | `tree-names: …-write-the-draft-the-brief-asks-for-in-94df79 is cut for run ?` — the cut begins | |
| **23:57:09.145** | the tree path is written on the row (`cutAt`) | **0 s** |
| 23:57:11 | `restart: panel restart queued (5f3c284d) by assistant: serve 1.67.3: …` — the panel that had just landed the round-6 fix restarts to serve it | **~2 s** (and no start) |
| 23:57:23 → 23:57:57 | Assistant #1's own turn (`570c2139`) | — |
| **23:58:16** | the panel boots: `scheduler started`, `pipeline waits: one ticker every 60s`, `projects: 177 … discovery 55ms` | **1 m 07 s down** |
| 23:58:18 → 23:58:45 | the boot's project sweep: `fetched origin for agent-worktree-gui`, then twelve `fetch failed … ssh: connect to host git.sefl.com port 22: Connection timed out` lines and one auth failure — synchronous git calls on the event loop | |
| **23:59:33** | `parents: 31 branch(es) resolved` — the last boot line before the ask | **1 m 17 s** |
| **00:00:13.655** | `stageRuns[0].at` — the pass asks for the stage's worker (job `5056fb50` 1.078 s later) | **40.7 s** |

## The account, in four parts

1. **2 s — nothing fires at the cut's end.** The cut writes the row's tree and its pass ends. The next pass is the
   queue tick, so the first stage waits for a timer by construction. This is the defect, and it is the only segment
   the pipeline owns.
2. **1 m 07 s — the panel was down.** A restart was queued two seconds after the cut (to serve the release that had
   just landed, with the round-6 fix in it). No tick could run while the process was restarting.
3. **1 m 17 s — the boot held the event loop.** Project discovery and origin fetches are synchronous `git` calls; this
   boot spent the window on twelve SSH timeouts to `git.sefl.com` (10–20 s each, the whole window) and one credential
   failure. While a synchronous fetch is in flight the assistant's tick cannot run at all.
4. **40.7 s — the first pass over the board, unlogged.** Between the last boot line (23:59:33) and the ask (00:00:13)
   the log says nothing; the next thing the panel does is ask for the start. This is the assistant's boot pass — the
   job store, the rule pass and the digest — before its queue sweep. Nothing in the log breaks it down further, and
   this report does not claim to.

Round 6's 0.853 s is the same code with segments 2, 3 and 4 absent: the panel was idle, no restart was pending, and
the tick that followed the cut was the next tick.

## What this changes in the code

`cutPipelineTree` now ends in `handOffFromTree`: the pass that wrote the tree asks for the stage's start in the same
turn, instead of leaving it to the next queue tick. That removes segment 1 for every cut — a fork, a lane, a join, a
plain row — and it is the half of the number the pipeline owns.

It does not remove segments 2, 3 or 4, and it should not pretend to: a panel that is restarting or fetching cannot
start anything, and a future round that restarts in the same minute as a cut will still show a wait. What changes is
that the wait is now the panel's unavailability, not the pipeline's silence — and a wait that is the panel's will say
so: the handoff logs when it could not run, and the next tick asks again.

The evidence this report rests on is not in the repository: the log and the two stores live under the panel's own
state directory (`logs/server.out.log`, `state/assistants/assistant-2/queue.json`, `state/jobs.json`). The numbers are
reproduced here so the review's figure can be checked against them, and the four stamps the row already carries
(`createdAt`, `tree.cutAt`, `stageRuns[].at`, `doneAt`) are enough to show a wait without them — they are not enough
to say why, which is what this report is for.
