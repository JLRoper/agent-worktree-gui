# Ping-pong run log - stage 1, the drafter

Wall clock is local, UTC-05:00, 2026-11-06. One line per event visible from inside; where an event exists only in the panel's own book, the source is named. The artifact is `ledger/ping-pong/draft.md`.

- 14:29:29 - tree cut from `main` at `28f57a0`, branch `wtgui/stage-1-of-2-the-drafter-8b0b20` (panel book: `~/.wag/state/branch-parents.json`, tag `8b0b20`; the cut left no marker in the tree).
- 14:29:45 - the brief's three TODO items filed for this tree (panel: `~/.wag/state/todos.json` and `GET /api/todos`).
- 14:29:47 - row #211 started; stage run `ping-pong/draft#1` stamped with thread `wtgui-stage-1-of-2-the-drafter-in-f13797` and job `ee265bc1` (panel: `~/.wag/state/assistants/assistant-2/queue.json`).
- 14:30:33 - turn started: first command in this worktree.
- 14:30:33 to 14:39:38 - read `docs/design/pipeline-stage-execution.md`, `docs/task-pipeline.md`, `lib/task-pipeline.js`, `lib/task-pipeline-drive.js`, `lib/pipeline-window.js`, `public/pipeline-flow.js`, `public/assistant.js`, and the live queue and TODO records.
- 14:39:38 - base check: HEAD `28f57a0`; `main` is one commit ahead at `c28111e` (the changelog render), so "cut from main" was true at 14:29:29 and the base has moved since. No rebase: this branch is local-only (see the push line below), and the draft cites the tree it read.
- 14:41:36 - `ledger/ping-pong/draft.md` first written (7074 bytes).
- 14:43:10 - draft tightened to 928 words for the one-page limit; re-checked, 0 em dashes and 0 en dashes.
- 14:44:00 - this log written, with the events above and the hand-off faults below.

Hand-off faults, and what it did right:

- The cut left no cut stamp or ledger skeleton in the tree; the 14:29:29 line had to be back-filled from `branch-parents.json`, so the log's first event is not visible from inside the tree.
- The brief did not carry the bundle stage prompt's closing instruction to name what the drafter is unsure of; the draft follows it anyway, in its last section.
- The brief names "stage 1 of 2" but not stage 2, the critique artifact or the gate; `pipeline-bundle.json` says `critique`, `ledger/ping-pong/critique.md`, gate G1 after critique.
- The brief names neither the row id (#211) nor the pipeline id (`ping-pong`); both were read from the queue record.
- The brief's LANDING paragraph orders `git push -u origin HEAD` and `gh pr create --fill` for a `wtgui/*` ref. The project's push scope keeps a `wtgui/*` branch local (`docs/pushing-to-a-remote.md` gates 1-3; the panel's own doctrine), and the TODO list has no push or PR item. The push is withheld and no PR is opened; the commit stays on the branch for the panel's landing.
- What it did right: it cut the tree 18 seconds before the start, stamped the stage run with the thread and job before the turn began, and put both expected files on the row's `files` list. No input artifact was handed, which matches `draft`'s empty `inputs.read` and visit 1.
- Ordering anomaly: the job record `ee265bc1` says `startedAt` 19:29:19.534Z, ten seconds before the tree's cut stamp (19:29:29.323Z) and 28 seconds before the row's start stamp (19:29:47.317Z). Either the job's start is stamped at the request, or the worker was asked for before its tree existed; from inside, the first command ran at 14:30:33, by which time the tree was there.
- 14:44:33 - commit `4826ed9` "docs: a failed stage run reads as failed on its pipeline row" on `wtgui/stage-1-of-2-the-drafter-8b0b20`; two files, 76 insertions, no product code.
- 14:44:58 - final queue read before the closing checks: row #211 `running`, `hold: null`, stage `ping-pong/draft`; `stageRuns` still one entry `ping-pong/draft#1`, `status: null`, `decision: null`; no `critique` entry. The job `ee265bc1` still reads `running`. The hand-off has not advanced, parked or settled anything: the settle is the panel's own read after this job's terminal status, and nothing in the tree can write it.
- 14:46:19 - second commit on the branch: this log's tail (the commit stamp, the queue read and the turn end), one file.
- 14:48 - turn end: the closing message follows, and this is the last line written in the tree.
